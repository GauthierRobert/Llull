/**
 * @layer ui/viewport/2d
 *
 * MeasureBBoxRect2D — renders the `measure_bounding_box` result as a rectangle outline on the XY
 * plane in the 2D orthographic viewport (the Z extent is ignored in a top-down view).
 *
 * Mounted inside the floating-origin group in SceneContents2D (Viewport2D.tsx).
 * - Geometry and material are disposed on unmount (R9).
 * - useBoundingBoxMeasure invalidates the demand-mode canvas when the bbox data changes.
 * - Purely presentational — no document mutation (PRIME DIRECTIVE).
 */

import type { Vec3 } from '@core/model/types';
import { anchoredGeometry } from '../lineGeometry';
import { useEffect, useMemo } from 'react';
import { useBoundingBoxMeasure } from '../useBoundingBoxMeasure';
import { useOverlayMaterial } from '../useOverlayMaterial';

/** Draw height: slightly above the entities. */
const RECT_Z = 0.1;

function RectLines2D({ min, max }: { min: Vec3; max: Vec3 }): React.ReactElement {
  const [x0, y0] = min;
  const [x1, y1] = max;

  const anchored = useMemo(
    () =>
      anchoredGeometry(
        [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ],
        RECT_Z,
      ),
    [x0, y0, x1, y1],
  );
  useEffect(() => () => anchored.geometry.dispose(), [anchored]);
  const material = useOverlayMaterial('#60a5fa', 0.9);

  // lineLoop closes the last→first segment automatically.
  return (
    <lineLoop
      geometry={anchored.geometry}
      position={anchored.anchor}
      material={material}
      renderOrder={999}
    />
  );
}

export function MeasureBBoxRect2D(): React.ReactElement | null {
  const bbox = useBoundingBoxMeasure();
  if (!bbox) return null;
  return <RectLines2D min={bbox.min} max={bbox.max} />;
}
