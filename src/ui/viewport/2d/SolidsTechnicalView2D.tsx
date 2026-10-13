/**
 * SolidsTechnicalView2D — the 3D solids in the 2D drafting view as a technical top view
 * (`technicalView`, the same projection the DXF export writes): thick visible edges, dashed hidden
 * edges (hidden by every solid, not only their own), chain centre lines and, while a downward-kept
 * horizontal section plane is active (the 3D clipping plane, axis z flipped), the hatched cut.
 */

import React, { useMemo } from 'react';
import type { Entity, EntityId } from '@core/model/types';
import { technicalView } from '@core/geometry/technicalView';
import { TOP_VIEW } from '@core/geometry/viewProjection';
import { drawingBounds } from '@core/model/drawing';
import { useStore } from '@ui/store';
import { SELECTION_COLOR, useViewportPalette } from '../viewportPalette';
import { useSectionCutDepth } from './sectionCut';
import { DrawingPrimitives2D } from './DrawingPrimitives2D';
import type { DrawingScale, StyledPrimitive } from './drawingGeometry';

/** Line-pattern unit and hatch pitch as fractions of the solids' plan extent. */
const PATTERN_FRACTION = 1 / 240;
const HATCH_FRACTION = 1 / 80;

export function SolidsTechnicalView2D({
  solids,
  selectedIds,
}: {
  solids: ReadonlyArray<Entity>;
  selectedIds: ReadonlySet<EntityId>;
}): React.ReactElement | null {
  const components = useStore((s) => s.document.components);
  const palette = useViewportPalette();
  const cutDepth = useSectionCutDepth();

  const drawings = useMemo(() => technicalView({ components }, solids, { frame: TOP_VIEW, cutDepth }), [components, solids, cutDepth]);
  const scale = useMemo((): DrawingScale => {
    const [minX, minY, maxX, maxY] = drawingBounds(drawings.flatMap((d) => d.primitives));
    const extent = Math.max(Math.hypot(maxX - minX, maxY - minY), 1e-6);
    return { patternUnit: extent * PATTERN_FRACTION, hatchSpacing: extent * HATCH_FRACTION };
  }, [drawings]);
  const items = useMemo((): StyledPrimitive[] => {
    const colorOf = new Map(solids.map((solid) => [solid.id, solid.color]));
    return drawings.flatMap(({ entityId, primitives }) => {
      const color = selectedIds.has(entityId) ? SELECTION_COLOR : (colorOf.get(entityId) ?? palette.background);
      return primitives.map((primitive) => ({ primitive, color }));
    });
  }, [drawings, solids, selectedIds, palette.background]);

  return <DrawingPrimitives2D name="solids-technical-view-2d" items={items} scale={scale} fillColor={palette.background} />;
}
