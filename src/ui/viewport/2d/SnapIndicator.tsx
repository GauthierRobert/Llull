// 2D snap glyph under the pointer (tracked via an invisible ground plane); the shape encodes the snap type. Read-only (R1).

import { useState } from 'react';
import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import { chainSegments, ellipseOutline, loopSegments, segmentsGeometry } from '../lineGeometry';
import { useDisposable } from '../useDisposable';
import { SNAP_COLORS_2D } from '../viewportPalette';
import { useZoomSnap } from './useSnap';
import { pixelsToWorld } from './gridHelpers';
import type { SnapType } from './snapping/types';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

/** Glyph half-size the geometry is built at; rescaled to a constant ~GLYPH_TARGET_PX on screen (scale 1 at default zoom 50). */
const GLYPH_SIZE = 0.22;

const GLYPH_TARGET_PX = 11;

const HALF = GLYPH_SIZE;
const TRIANGLE_HEIGHT = HALF * Math.sqrt(3);
const TICK = HALF * 0.35;

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
  // Right angle with a corner tick.
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
  tangent: [
    [-HALF, HALF * 0.5],
    [HALF, HALF * 0.5],
    [0, HALF * 0.5],
    [0, -HALF],
  ],
  // Gap marked by a vertical tick.
  extension: [
    [-HALF, 0],
    [-HALF * 0.3, 0],
    [HALF * 0.3, 0],
    [HALF, 0],
    [-HALF * 0.1, -HALF * 0.4],
    [-HALF * 0.1, HALF * 0.4],
  ],
  // Dot inside a ring.
  nearest: [...ellipseOutline(0, 0, HALF, HALF, 10), ...ellipseOutline(0, 0, HALF * 0.3, HALF * 0.3, 4)],
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
  zoom: number;
}

function SnapGlyph({ snapType, x, y, zoom }: GlyphProps): React.ReactElement {
  const geometry = useDisposable(() => segmentsGeometry(GLYPH_VERTICES[snapType]), [snapType]);
  const material = useDisposable(
    () => new THREE.LineBasicMaterial({ color: SNAP_COLORS_2D[snapType], linewidth: 2, depthTest: false }),
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

/** Mount inside the Viewport2D scene. */
export function SnapIndicator({ zoom }: { zoom: number }): React.ReactElement {
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
        <SnapGlyph key={snapResult.type} snapType={snapResult.type} x={snapResult.x} y={snapResult.y} zoom={zoom} />
      )}
    </>
  );
}
