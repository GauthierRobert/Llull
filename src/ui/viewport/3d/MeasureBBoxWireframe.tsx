/**
 * @layer ui/viewport/3d
 *
 * MeasureBBoxWireframe — renders the `measure_bounding_box` result as a
 * wireframe box in the 3D scene. Mounted inside the floating-origin group
 * in SceneContents (Viewport3D.tsx) alongside the entity group.
 *
 * - Geometry is built with useMemo and disposed on unmount (R9).
 * - Calls invalidate() when the bbox data changes so the demand-mode canvas
 *   renders the overlay immediately (frameloop="demand").
 * - Reads `lastMeasure` from the store via a narrow selector (R3).
 * - Purely presentational — no document mutation (PRIME DIRECTIVE).
 */

import { useMemo, useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Type narrowing for the bbox data shape
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
// BBoxLines — renders the 12 edges of the AABB as a LineSegments object
// ---------------------------------------------------------------------------

interface BBoxLinesProps {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

function BBoxLines({ min, max }: BBoxLinesProps): React.ReactElement | null {
  const geometry = useMemo(() => {
    // Build the 8 corners of the AABB, then wire up 12 edges.
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;

    // 8 corners (consistent winding for readability)
    const corners: [number, number, number][] = [
      [x0, y0, z0], // 0 — BLF (bottom-left-front)
      [x1, y0, z0], // 1 — BRF
      [x1, y1, z0], // 2 — TRF
      [x0, y1, z0], // 3 — TLF
      [x0, y0, z1], // 4 — BLB
      [x1, y0, z1], // 5 — BRB
      [x1, y1, z1], // 6 — TRB
      [x0, y1, z1], // 7 — TLB
    ];

    // 12 edges (each is a pair of corner indices) — typed as readonly tuples to
    // satisfy noUncheckedIndexedAccess (destructuring from a typed tuple is safe).
    const edges: readonly [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0], // front face
      [4, 5], [5, 6], [6, 7], [7, 4], // back face
      [0, 4], [1, 5], [2, 6], [3, 7], // connecting edges
    ];

    const positions: number[] = [];
    for (const [a, b] of edges) {
      const ca = corners[a]!;
      const cb = corners[b]!;
      positions.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2]);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geo;
  }, [min, max]);

  const material = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: '#60a5fa', // accent blue matching --accent
        linewidth: 1,     // wider not supported on all platforms
        depthTest: false, // always visible through geometry
        transparent: true,
        opacity: 0.85,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <lineSegments geometry={geometry} material={material} renderOrder={999} />;
}

// ---------------------------------------------------------------------------
// MeasureBBoxWireframe — exported; mounts inside the floating-origin group
// ---------------------------------------------------------------------------

/**
 * Reads the last measure result and, if it is a bounding-box result, renders
 * the wireframe box. Adjusts positions relative to the renderOrigin offset
 * (the caller group already applies -renderOrigin, so positions are in document
 * world coords — pass them through unchanged).
 */
export function MeasureBBoxWireframe(): React.ReactElement | null {
  const lastMeasure = useStore((s) => s.lastMeasure);
  const { invalidate } = useThree();

  // Call invalidate when the measure data changes so demand-mode canvas redraws.
  useEffect(() => {
    invalidate();
  }, [lastMeasure, invalidate]);

  if (!lastMeasure || lastMeasure.command !== 'measure_bounding_box') return null;
  if (!isBBoxData(lastMeasure.data)) return null;

  const { min, max } = lastMeasure.data;
  return <BBoxLines min={min} max={max} />;
}
