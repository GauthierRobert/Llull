/**
 * @layer ui/viewport/2d
 *
 * Maps `document.order` → 2D shape entities, with ONE pure render branch per
 * Shape2DKind. Non-2D (solid) entities are skipped — they belong to Viewport3D.
 *
 * Respects layer visibility. Selection state is forwarded to each branch.
 * Uses entity `id` as React key (R8).
 */

import type { CadDocument, Entity, EntityId } from '@core/model/types';
import { is2D } from '@core/model/types';
import { useViewportStore } from '@ui/store';
import { LineRenderer } from './entities/LineRenderer';
import { PolylineRenderer } from './entities/PolylineRenderer';
import { CircleRenderer } from './entities/CircleRenderer';
import { ArcRenderer } from './entities/ArcRenderer';
import { RectangleRenderer } from './entities/RectangleRenderer';
import { PointRenderer } from './entities/PointRenderer';
import { EllipseRenderer } from './entities/EllipseRenderer';
import { SplineRenderer } from './entities/SplineRenderer';

interface Entities2DProps {
  document: CadDocument;
}

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
    // 3D solid kinds are intentionally not rendered here.
    default:
      return null;
  }
}

export function Entities2D({ document }: Entities2DProps): React.ReactElement {
  const { order, entities, layers, selection } = document;
  const selectionSet = new Set<EntityId>(selection);

  // Render-only local layer-hide filter — never touches the document (PRIME DIRECTIVE).
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);

  return (
    <group name="entities-2d">
      {order.map((id) => {
        const entity = entities[id];
        if (!entity) return null;
        if (!is2D(entity)) return null;

        // Respect layer visibility (document) and the local layer-hide filter (UI).
        const layer = layers[entity.layerId];
        if (layer && !layer.visible) return null;
        if (hiddenLayerIds.has(entity.layerId)) return null;

        return <Entity2DRenderer key={id} entity={entity} selected={selectionSet.has(id)} />;
      })}
    </group>
  );
}
