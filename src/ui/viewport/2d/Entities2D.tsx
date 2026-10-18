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
import { useTransitioningIds } from '@ui/store/transitioningIds';
import { LiveTransitionGroup } from '../liveFx/LiveTransitionGroup';
import { type GhostRenderer, LiveFxLayer } from '../liveFx/LiveFxLayer';

/** 2D shapes only: solids are projected together by SolidsTechnicalView2D. */
const renderGhost2D: GhostRenderer = (ghost) => (is2D(ghost.entity) ? <Shape2DRenderer entity={ghost.entity} selected={false} /> : null);

export function Entities2D(): React.ReactElement {
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  const layers = useStore((s) => s.document.layers);
  const selection = useStore((s) => s.document.selection);

  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);

  const selectedIds = useMemo(() => new Set<EntityId>(selection), [selection]);
  const transitions = useTransitioningIds();

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
      if (entity.kind === 'line' && !selected && !transitions.has(entity.id)) lines.push(entity);
      else rest.push({ entity, selected });
    }
    return { batchedLines: lines, individual: rest };
  }, [visible, selectedIds, transitions]);

  return (
    <group name="entities-2d">
      <BatchedLines2D lines={batchedLines} />
      <SolidsTechnicalView2D solids={solids} selectedIds={selectedIds} />
      {individual.map(({ entity, selected }) => (
        <LiveTransitionGroup key={entity.id} entity={entity}>
          <Shape2DRenderer entity={entity} selected={selected} />
        </LiveTransitionGroup>
      ))}
      <LiveFxLayer renderGhost={renderGhost2D} />
    </group>
  );
}
