/**
 * @layer ui/viewport
 *
 * Narrow store read of the last `measure_bounding_box` result for the 2D and 3D overlays.
 * Calls r3f `invalidate()` when the measure changes so a `frameloop="demand"` canvas repaints.
 * Must be used inside a Canvas. Presentational only — no document mutation.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '@ui/store';
import { isBoundingBoxData } from '@ui/resultData';

interface BoundingBoxMeasure {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  size: readonly [number, number, number];
}

export function useBoundingBoxMeasure(): BoundingBoxMeasure | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    invalidate();
  }, [lastMeasure, invalidate]);

  if (!lastMeasure || lastMeasure.command !== 'measure_bounding_box') return null;
  return isBoundingBoxData(lastMeasure.data) ? lastMeasure.data : null;
}
