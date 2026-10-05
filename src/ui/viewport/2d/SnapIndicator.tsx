/**
 * @layer ui/viewport/2d
 *
 * Visual snap indicator for the 2D drafting viewport.
 *
 * Tracks the pointer over the 2D canvas via an invisible ground plane, computes the snapped
 * position and renders a small glyph whose shape encodes the snap type:
 *
 *   endpoint      → square (magenta)
 *   midpoint      → triangle (cyan)
 *   center        → circle (yellow)
 *   intersection  → X cross (orange)
 *   perpendicular → right-angle symbol (green)
 *   tangent       → T-mark (lime)
 *   extension     → dashed line cap (teal)
 *   nearest       → dot with ring (blue)
 *   grid          → plus (dim white)
 *
 * Presentation only — reads the document via useSnap; NEVER mutates it (R1).
 * Geometries/materials are disposed on unmount (R9).
 */

import { useState } from 'react';
import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import { chainSegments, ellipseOutline, loopSegments, segmentsGeometry } from '../lineGeometry';
import { useDisposable } from '../useDisposable';
import { useZoomSnap } from './useSnap';
import { pixelsToWorld } from './gridHelpers';
import type { SnapType } from './snapping/types';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

const SNAP_COLORS: Record<SnapType, string> = {
  endpoint: '#e040fb', // magenta
  midpoint: '#00e5ff', // cyan
  center: '#ffee58', // yellow
  intersection: '#ff9800', // orange
  perpendicular: '#69f0ae', // green
  tangent: '#b9f6ca', // lime
  extension: '#26c6da', // teal
  nearest: '#40c4ff', // blue
  grid: '#546e7a', // muted blue-grey
};

/**
 * Base glyph half-size the geometry is built at (world units). The rendered glyph is rescaled so
 * its ON-SCREEN size stays ~GLYPH_TARGET_PX regardless of zoom — otherwise it would be invisible
 * when zoomed out and enormous when zoomed in. GLYPH_SIZE × default-zoom (50) ≈ GLYPH_TARGET_PX,
 * so the scale is 1 at the default zoom.
 */
const GLYPH_SIZE = 0.22;

/** Target on-screen glyph half-size in pixels (≈ GLYPH_SIZE × default zoom 50). */
const GLYPH_TARGET_PX = 11;

const HALF = GLYPH_SIZE;
const TRIANGLE_HEIGHT = HALF * Math.sqrt(3);
const TICK = HALF * 0.35;

/** Segment vertex pairs of each glyph, centred on the snap point. */
const GLYPH_VERTICES: Record<SnapType, Vec2[]> = {
  endpoint: loopSegments([
    [-HALF, -HALF],
    [HALF, -HALF],
    [HALF, HALF],
    [-HALF, HALF],
  ]),
  midpoint: loopSegments([
    [0, (TRIANGLE_HEIGHT * 2) / 3],
    [HALF, -TRIANGLE_HEIGHT / 3],
    [-HALF, -TRIANGLE_HEIGHT / 3],
  ]),
  center: ellipseOutline(0, 0, HALF, HALF, 16),
  intersection: [
    [-HALF, -HALF],
    [HALF, HALF],
    [-HALF, HALF],
    [HALF, -HALF],
  ],
  // L-shaped right-angle symbol with a small corner tick.
  perpendicular: [
    ...chainSegments([
      [0, -HALF],
      [0, 0],
      [HALF, 0],
    ]),
    ...chainSegments([
      [TICK, 0],
      [TICK, TICK],
      [0, TICK],
    ]),
  ],
  // Horizontal bar with a vertical stem.
  tangent: [
    [-HALF, HALF * 0.5],
    [HALF, HALF * 0.5],
    [0, HALF * 0.5],
    [0, -HALF],
  ],
  // Short horizontal line with a gap, marked by a vertical tick.
  extension: [
    [-HALF, 0],
    [-HALF * 0.3, 0],
    [HALF * 0.3, 0],
    [HALF, 0],
    [-HALF * 0.1, -HALF * 0.4],
    [-HALF * 0.1, HALF * 0.4],
  ],
  // Small dot inside a larger ring.
  nearest: [
    ...ellipseOutline(0, 0, HALF, HALF, 10),
    ...ellipseOutline(0, 0, HALF * 0.3, HALF * 0.3, 4),
  ],
  grid: [
    [-HALF, 0],
    [HALF, 0],
    [0, -HALF],
    [0, HALF],
  ],
};

interface GlyphProps {
  snapType: SnapType;
  x: number;
  y: number;
  /** Ortho camera zoom — used to keep the glyph a constant on-screen size. */
  zoom: number;
}

function SnapGlyph({ snapType, x, y, zoom }: GlyphProps): React.ReactElement {
  const geometry = useDisposable(() => segmentsGeometry(GLYPH_VERTICES[snapType]), [snapType]);
  const material = useDisposable(
    () =>
      new THREE.LineBasicMaterial({ color: SNAP_COLORS[snapType], linewidth: 2, depthTest: false }),
    [snapType],
  );
  return (
    <lineSegments
      geometry={geometry}
      material={material}
      position={[x, y, 0.1]}
      scale={pixelsToWorld(GLYPH_TARGET_PX, zoom) / GLYPH_SIZE}
      renderOrder={999}
    />
  );
}

interface SnapIndicatorProps {
  /** Current ortho camera zoom — drives the adaptive snap grid + glyph size. */
  zoom: number;
}

/** Mount inside the r3f scene in Viewport2D: tracks the pointer and renders the snap glyph. */
export function SnapIndicator({ zoom }: SnapIndicatorProps): React.ReactElement {
  const [cursor, setCursor] = useState<Vec2 | null>(null);

  const snapResult = useZoomSnap(cursor, zoom);

  return (
    <>
      <GroundPlane
        onPointerMove={(e) => {
          e.stopPropagation();
          setCursor(toDocumentPoint(e.point));
        }}
        onPointerLeave={(e) => {
          e.stopPropagation();
          setCursor(null);
        }}
      />
      {snapResult?.snapped && snapResult.type !== null && (
        <SnapGlyph
          key={snapResult.type}
          snapType={snapResult.type}
          x={snapResult.x}
          y={snapResult.y}
          zoom={zoom}
        />
      )}
    </>
  );
}
