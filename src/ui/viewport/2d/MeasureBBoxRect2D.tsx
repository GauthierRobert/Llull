// `measure_bounding_box` result as an XY rectangle (Z ignored) in the 2D view, inside the floating-origin group.

import type { Vec3 } from '@core/model/types';
import { useAnchoredGeometry } from '../useDisposable';
import { useBoundingBoxMeasure } from '../useBoundingBoxMeasure';
import { useOverlayMaterial } from '../useOverlayMaterial';
import { OVERLAY_ACCENT } from '../viewportPalette';

/** Slightly above the entities. */
const RECT_Z = 0.1;

function RectLines2D({ min, max }: { min: Vec3; max: Vec3 }): React.ReactElement {
  const [x0, y0] = min;
  const [x1, y1] = max;

  const anchored = useAnchoredGeometry(
    () => [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    RECT_Z,
    [x0, y0, x1, y1],
  );
  const material = useOverlayMaterial(OVERLAY_ACCENT, 0.9);

  return <lineLoop geometry={anchored.geometry} position={anchored.anchor} material={material} renderOrder={999} />;
}

export function MeasureBBoxRect2D(): React.ReactElement | null {
  const bbox = useBoundingBoxMeasure();
  if (!bbox) return null;
  return <RectLines2D min={bbox.min} max={bbox.max} />;
}
