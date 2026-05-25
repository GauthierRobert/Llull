/**
 * @layer ui/viewport/2d
 *
 * MeasureBBoxRect2D — renders the `measure_bounding_box` result as a
 * rectangle outline on the XY plane in the 2D orthographic viewport.
 *
 * Mounted inside the floating-origin group in SceneContents2D (Viewport2D.tsx).
 * Only the XY extents are shown (top-down view ignores the Z axis).
 *
 * - Geometry built with useMemo + disposed on unmount (R9).
 * - Calls invalidate() when bbox data changes under frameloop="demand".
 * - Reads `lastMeasure` via a narrow selector (R3).
 * - Purely presentational — no document mutation (PRIME DIRECTIVE).
 */

import { useMemo, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Type narrowing
// ---------------------------------------------------------------------------

interface BBoxData {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  size: readonly [number, number, number];
}

function isBBoxData(d: unknown): d is BBoxData {
  return typeof d === 'object' && d !== null && 'min' in d && 'max' in d && 'size' in d;
}

// ---------------------------------------------------------------------------
// RectLines2D — XY rectangle rendered as a LineLoop on Z=0.1 (above entities)
// ---------------------------------------------------------------------------

interface RectLines2DProps {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

function RectLines2D({ min, max }: RectLines2DProps): React.ReactElement | null {
  const [x0, y0] = min;
  const [x1, y1] = max;

  const geometry = useMemo(() => {
    // 4 corners of the XY rectangle, slightly above the entities (z=0.1)
    const pts = [
      x0, y0, 0.1,
      x1, y0, 0.1,
      x1, y1, 0.1,
      x0, y1, 0.1,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  }, [x0, y0, x1, y1]);

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#60a5fa',
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // lineLoop closes the last→first segment automatically.
  return <lineLoop geometry={geometry} material={material} renderOrder={999} />;
}

// ---------------------------------------------------------------------------
// MeasureBBoxRect2D — exported; mounts inside the floating-origin group
// ---------------------------------------------------------------------------

export function MeasureBBoxRect2D(): React.ReactElement | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const { invalidate } = useThree();

  useEffect(() => {
    invalidate();
  }, [lastMeasure, invalidate]);

  if (!lastMeasure || lastMeasure.command !== 'measure_bounding_box') return null;
  if (!isBBoxData(lastMeasure.data)) return null;

  const { min, max } = lastMeasure.data;
  return <RectLines2D min={min} max={max} />;
}
