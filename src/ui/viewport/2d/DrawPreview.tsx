/**
 * @layer ui/viewport/2d
 *
 * Rubber-band previews rendered inside the r3f scene while a draw tool is active, and the
 * markers on already-placed vertices. Geometry is rebuilt per change and disposed (R9).
 *
 * Presentation only — no document mutations (R1). Reads draw state from props.
 */

import { useMemo } from 'react';
import type * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from '@ui/store';
import { chainSegments, ellipseOutline, loopSegments, segmentsGeometry } from '../lineGeometry';
import { useDisposable } from '../useDisposable';
import { useOverlayMaterial } from '../useOverlayMaterial';
import {
  CHAIN_DRAW_TOOLS,
  rectParamsFromCorners,
  circleRadiusFromPoints,
  ellipseParamsFromCenterCorner,
} from './drawHelpers';

const PREVIEW_COLOR = '#60a5fa'; // blue-400
const PREVIEW_HINT_COLOR = '#94a3b8'; // slate-400
const MARKER_COLOR = '#f59e0b';
const OUTLINE_SEGMENTS = 32;
const CROSSHAIR_RADIUS = 0.15;
const MARKER_RADIUS = 0.12;

interface Preview {
  /** Segment vertex pairs. */
  vertices: Vec2[];
  /** Faint style, used for the crosshair shown before the first point is placed. */
  hint: boolean;
}

/** Outline previewed from the single placed point to the cursor; null while degenerate. */
const ANCHORED_OUTLINES: Partial<
  Record<DrawToolKind, (anchor: Vec2, cursor: Vec2) => Vec2[] | null>
> = {
  line: (anchor, cursor) => [anchor, cursor],
  move: (anchor, cursor) => [anchor, cursor],
  circle: (center, rim) => {
    const radius = circleRadiusFromPoints(center, rim);
    return radius === null
      ? null
      : ellipseOutline(center[0], center[1], radius, radius, OUTLINE_SEGMENTS);
  },
  rectangle: (a, b) => {
    if (rectParamsFromCorners(a, b) === null) return null;
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    return loopSegments([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]);
  },
  ellipse: (center, corner) => {
    const ellipse = ellipseParamsFromCenterCorner(center, corner);
    return ellipse === null
      ? null
      : ellipseOutline(
          ellipse.center[0],
          ellipse.center[1],
          ellipse.radiusX,
          ellipse.radiusY,
          OUTLINE_SEGMENTS,
        );
  },
};

/** Chain tools preview a straight-segment rubber band; the others an outline from the one placed point. */
function previewOf(tool: DrawToolKind, points: ReadonlyArray<Vec2>, cursor: Vec2): Preview | null {
  if (CHAIN_DRAW_TOOLS.has(tool)) {
    if (points.length > 0) return { vertices: chainSegments([...points, cursor]), hint: false };
    const [x, y] = cursor;
    const r = CROSSHAIR_RADIUS;
    return {
      vertices: [
        [x - r, y],
        [x + r, y],
        [x, y - r],
        [x, y + r],
      ],
      hint: true,
    };
  }
  const anchor = points.length === 1 ? points[0] : undefined;
  const vertices = anchor ? ANCHORED_OUTLINES[tool]?.(anchor, cursor) : null;
  return vertices ? { vertices, hint: false } : null;
}

interface OverlaySegmentsProps {
  vertices: Vec2[];
  material: THREE.LineBasicMaterial;
  renderOrder: number;
}

function OverlaySegments({
  vertices,
  material,
  renderOrder,
}: OverlaySegmentsProps): React.ReactElement {
  const geometry = useDisposable(() => segmentsGeometry(vertices), [vertices]);
  return <lineSegments geometry={geometry} material={material} renderOrder={renderOrder} />;
}

interface DrawPreviewProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  /** Current snapped cursor position; null when the cursor is off-canvas. */
  cursor: Vec2 | null;
}

/** Draws over entities (renderOrder 998) but under snap glyphs. */
export function DrawPreview({
  activeTool,
  collectedPoints,
  cursor,
}: DrawPreviewProps): React.ReactElement | null {
  const solidMaterial = useOverlayMaterial(PREVIEW_COLOR, 0.85);
  const hintMaterial = useOverlayMaterial(PREVIEW_HINT_COLOR, 0.5);
  const preview = useMemo(
    () => (cursor === null ? null : previewOf(activeTool, collectedPoints, cursor)),
    [activeTool, collectedPoints, cursor],
  );

  if (!preview) return null;
  return (
    <OverlaySegments
      vertices={preview.vertices}
      material={preview.hint ? hintMaterial : solidMaterial}
      renderOrder={998}
    />
  );
}

/** Small square marker at each already-collected vertex. */
export function CollectedPointMarkers({ points }: { points: Vec2[] }): React.ReactElement | null {
  const material = useOverlayMaterial(MARKER_COLOR);
  const vertices = useMemo(
    () =>
      points.flatMap(([x, y]) => {
        const r = MARKER_RADIUS;
        return loopSegments([
          [x - r, y - r],
          [x + r, y - r],
          [x + r, y + r],
          [x - r, y + r],
        ]);
      }),
    [points],
  );

  if (points.length === 0) return null;
  return <OverlaySegments vertices={vertices} material={material} renderOrder={997} />;
}
