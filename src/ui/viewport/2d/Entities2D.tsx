/**
 * @layer ui/viewport/2d
 *
 * Maps `document.order` → 2D shape entities, with ONE pure render branch per
 * Shape2DKind. Non-2D (solid) entities are skipped — they belong to Viewport3D.
 *
 * Respects layer visibility. Selection state is forwarded to each branch.
 * Uses entity `id` as React key (R8).
 */

import type { Entity, EntityId } from '@core/model/types';
import { is2D } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { LineRenderer } from './entities/LineRenderer';
import { PolylineRenderer } from './entities/PolylineRenderer';
import { CircleRenderer } from './entities/CircleRenderer';
import { ArcRenderer } from './entities/ArcRenderer';
import { RectangleRenderer } from './entities/RectangleRenderer';
import { PointRenderer } from './entities/PointRenderer';
import { EllipseRenderer } from './entities/EllipseRenderer';
import { SplineRenderer } from './entities/SplineRenderer';
import { TextRenderer2D } from './entities/TextRenderer2D';
import { DimensionRenderer2D } from './entities/DimensionRenderer2D';

/** Pure render branch for a single 2D entity; one case per Shape2DKind. */
function Entity2DRenderer({
  entity,
  selected,
}: {
  entity: Entity;
  selected: boolean;
}): React.ReactElement | null {
  switch (entity.kind) {
    case 'line':
      return <LineRenderer entity={entity} selected={selected} />;
    case 'polyline':
      return <PolylineRenderer entity={entity} selected={selected} />;
    case 'circle':
      return <CircleRenderer entity={entity} selected={selected} />;
    case 'arc':
      return <ArcRenderer entity={entity} selected={selected} />;
    case 'rectangle':
      return <RectangleRenderer entity={entity} selected={selected} />;
    case 'point':
      return <PointRenderer entity={entity} selected={selected} />;
    case 'ellipse':
      return <EllipseRenderer entity={entity} selected={selected} />;
    case 'spline':
      return <SplineRenderer entity={entity} selected={selected} />;
    case 'text':
      return <TextRenderer2D entity={entity} selected={selected} />;
    case 'dimension':
      return <DimensionRenderer2D entity={entity} selected={selected} />;
    // 3D solid kinds are intentionally not rendered here.
    default:
      return null;
  }
}

export function Entities2D(): React.ReactElement {
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  const layers = useStore((s) => s.document.layers);
  const selection = useStore((s) => s.document.selection);
  const selectionSet = new Set<EntityId>(selection);

  // Render-only hide filters — never touch the document (PRIME DIRECTIVE).
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  return (
    <group name="entities-2d">
      {order.map((id) => {
        const entity = entities[id];
        if (!entity) return null;
        if (!is2D(entity)) return null;
        // Building annotations are drawn per level by BuildingPlan2D.
        if (entity.tags?.includes('bim') === true) return null;

        if (!isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds)) return null;

        return <Entity2DRenderer key={id} entity={entity} selected={selectionSet.has(id)} />;
      })}
    </group>
  );
}
