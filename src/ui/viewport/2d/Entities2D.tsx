// `document.order` → the 2D view: ONE branch per Shape2DKind; 3D solids together as one technical top view
// (SolidsTechnicalView2D), so a solid hides edges beneath it.

import { useMemo } from 'react';
import { type Entity, type EntityId, type LineEntity, is2D } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { useStableList } from '../useStableByKey';
import { BatchedLines2D } from './BatchedLines2D';
import { Shape2DRenderer } from './Shape2DRenderer';
import { SolidsTechnicalView2D } from './SolidsTechnicalView2D';

export function Entities2D(): React.ReactElement {
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  const layers = useStore((s) => s.document.layers);
  const selection = useStore((s) => s.document.selection);

  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  const selectedIds = useMemo(() => new Set<EntityId>(selection), [selection]);

  const visible = useMemo(
    () =>
      order.flatMap((id) => {
        const entity = entities[id];
        // Building annotations are drawn per level by BuildingPlan2D.
        if (!entity || entity.tags?.includes('bim') === true) return [];
        return isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds) ? [entity] : [];
      }),
    [order, entities, layers, hiddenLayerIds, hiddenEntityIds],
  );
  // Stable through selection changes and unrelated edits: the projection reruns only when a solid changes.
  const solids = useStableList(useMemo(() => visible.filter((entity) => !is2D(entity)), [visible]));

  // Unselected lines share ONE batched draw call; selected lines keep their own renderer for the highlight.
  const { batchedLines, individual } = useMemo(() => {
    const lines: LineEntity[] = [];
    const rest: Array<{ entity: Entity; selected: boolean }> = [];
    for (const entity of visible) {
      if (!is2D(entity)) continue;
      const selected = selectedIds.has(entity.id);
      if (entity.kind === 'line' && !selected) lines.push(entity);
      else rest.push({ entity, selected });
    }
    return { batchedLines: lines, individual: rest };
  }, [visible, selectedIds]);

  return (
    <group name="entities-2d">
      <BatchedLines2D lines={batchedLines} />
      <SolidsTechnicalView2D solids={solids} selectedIds={selectedIds} />
      {individual.map(({ entity, selected }) => (
        <Shape2DRenderer key={entity.id} entity={entity} selected={selected} />
      ))}
    </group>
  );
}
