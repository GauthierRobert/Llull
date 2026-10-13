// `measure_bounding_box` result as a 3D wireframe box (world coords, inside the floating-origin group).

import type { Vec3 } from '@core/model/types';
import { positionsGeometry } from '../lineGeometry';
import { useBoundingBoxMeasure } from '../useBoundingBoxMeasure';
import { useDisposable } from '../useDisposable';
import { useOverlayMaterial } from '../useOverlayMaterial';
import { OVERLAY_ACCENT } from '../viewportPalette';

/** 12 box edges: corner bits 0/1/2 select max x/y/z; an edge joins corners differing in one bit. */
function boxEdgePositions([x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3): number[] {
  const corner = (index: number): Vec3 => [index & 1 ? x1 : x0, index & 2 ? y1 : y0, index & 4 ? z1 : z0];
  return [0, 1, 2, 3, 4, 5, 6, 7].flatMap((from) =>
    [1, 2, 4].filter((bit) => !(from & bit)).flatMap((bit) => [...corner(from), ...corner(from | bit)]),
  );
}

function BBoxLines({ min, max }: { min: Vec3; max: Vec3 }): React.ReactElement {
  const geometry = useDisposable(() => positionsGeometry(boxEdgePositions(min, max)), [min, max]);
  const material = useOverlayMaterial(OVERLAY_ACCENT, 0.85);
  return <lineSegments geometry={geometry} material={material} renderOrder={999} />;
}

export function MeasureBBoxWireframe(): React.ReactElement | null {
  const bbox = useBoundingBoxMeasure();
  if (!bbox) return null;
  return <BBoxLines min={bbox.min} max={bbox.max} />;
}
