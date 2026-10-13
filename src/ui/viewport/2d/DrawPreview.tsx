// In-scene rubber-band preview of the active draw tool + placed-vertex markers; geometry disposed per change (R9).

import { useMemo } from 'react';
import type * as THREE from 'three';
import type { Vec2 } from '@core/model/types';
import type { DrawToolKind } from '@ui/store';
import { chainSegments, loopSegments } from '../lineGeometry';
import { useAnchoredGeometry } from '../useDisposable';
import { useOverlayMaterial } from '../useOverlayMaterial';
import { OVERLAY_ACCENT } from '../viewportPalette';
import { pixelsToWorld } from './gridHelpers';
import { drawToolDescriptor } from './drawToolTable';

const PREVIEW_HINT_COLOR = '#94a3b8'; // slate-400
const MARKER_COLOR = '#f59e0b';
/** On-screen half-sizes (px), converted with the zoom so they never scale. */
const CROSSHAIR_RADIUS_PX = 8;
const MARKER_RADIUS_PX = 6;

interface Preview {
  /** Segment vertex pairs. */
  vertices: Vec2[];
  /** Faint crosshair before the first point. */
  hint: boolean;
}

/** Chain tools: straight-segment band; others: outline from the one placed point. */
function previewOf(tool: DrawToolKind, points: ReadonlyArray<Vec2>, cursor: Vec2, crosshairRadius: number): Preview | null {
  const outline = drawToolDescriptor(tool)?.preview;
  if (outline === undefined) return null;
  if (outline === 'chain') {
    if (points.length > 0) return { vertices: chainSegments([...points, cursor]), hint: false };
    const [x, y] = cursor;
    const r = crosshairRadius;
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
  const vertices = anchor ? outline(anchor, cursor) : null;
  return vertices ? { vertices, hint: false } : null;
}

function OverlaySegments({
  vertices,
  material,
  renderOrder,
}: {
  vertices: Vec2[];
  material: THREE.LineBasicMaterial;
  renderOrder: number;
}): React.ReactElement {
  const anchored = useAnchoredGeometry(() => vertices, 0, [vertices]);
  return <lineSegments geometry={anchored.geometry} material={material} renderOrder={renderOrder} position={anchored.anchor} />;
}

interface DrawPreviewProps {
  activeTool: DrawToolKind;
  collectedPoints: Vec2[];
  /** null when off-canvas. */
  cursor: Vec2 | null;
  /** Px per world unit. */
  zoom: number;
}

/** Draws over entities (renderOrder 998) but under snap glyphs. */
export function DrawPreview({ activeTool, collectedPoints, cursor, zoom }: DrawPreviewProps): React.ReactElement | null {
  const solidMaterial = useOverlayMaterial(OVERLAY_ACCENT, 0.85);
  const hintMaterial = useOverlayMaterial(PREVIEW_HINT_COLOR, 0.5);
  const crosshairRadius = pixelsToWorld(CROSSHAIR_RADIUS_PX, zoom);
  const preview = useMemo(
    () => (cursor === null ? null : previewOf(activeTool, collectedPoints, cursor, crosshairRadius)),
    [activeTool, collectedPoints, cursor, crosshairRadius],
  );

  if (!preview) return null;
  return <OverlaySegments vertices={preview.vertices} material={preview.hint ? hintMaterial : solidMaterial} renderOrder={998} />;
}

export function CollectedPointMarkers({ points, zoom }: { points: Vec2[]; zoom: number }): React.ReactElement | null {
  const material = useOverlayMaterial(MARKER_COLOR);
  const markerRadius = pixelsToWorld(MARKER_RADIUS_PX, zoom);
  const vertices = useMemo(
    () =>
      points.flatMap(([x, y]) => {
        const r = markerRadius;
        return loopSegments([
          [x - r, y - r],
          [x + r, y - r],
          [x + r, y + r],
          [x - r, y + r],
        ]);
      }),
    [points, markerRadius],
  );

  if (points.length === 0) return null;
  return <OverlaySegments vertices={vertices} material={material} renderOrder={997} />;
}
