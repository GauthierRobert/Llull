// Last `measure_bounding_box` result for the 2D / 3D overlays; invalidates the demand canvas on change (in-Canvas only).

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
