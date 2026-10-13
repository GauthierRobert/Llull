/**
 * Narrow store read of the last `measure_bounding_box` result for the 2D and 3D overlays.
 * Calls r3f `invalidate()` when the measure changes so a `frameloop="demand"` canvas repaints.
 * Must be used inside a Canvas. Presentational only — no document mutation.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore } from '@ui/store';
import { type BoundingBoxData, isBoundingBoxData } from '@ui/resultData';

export function useBoundingBoxMeasure(): BoundingBoxData | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const invalidate = useThree((s) => s.invalidate);

  useEffect(() => {
    invalidate();
  }, [lastMeasure, invalidate]);

  if (!lastMeasure || lastMeasure.command !== 'measure_bounding_box') return null;
  return isBoundingBoxData(lastMeasure.data) ? lastMeasure.data : null;
}
