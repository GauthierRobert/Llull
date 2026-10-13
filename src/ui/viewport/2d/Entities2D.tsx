/**
 * @layer ui/viewport/2d
 *
 * Maps `document.order` → the 2D drafting view: ONE pure render branch per Shape2DKind, and the
 * 3D solids together as their technical top view (SolidsTechnicalView2D — one projection, so a
 * solid hides the edges of those beneath it).
 *
 * Respects layer visibility. Selection state is forwarded to each branch.
 * Uses entity `id` as React key (R8).
 */

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

  // Render-only hide filters — never touch the document (PRIME DIRECTIVE).
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
  // Solids are projected together; the list keeps its identity through selection changes and
  // edits of other entities, so the projection only reruns when a solid changes.
  const solids = useStableList(useMemo(() => visible.filter((entity) => !is2D(entity)), [visible]));

  // Unselected lines are drawn in ONE batched draw call; everything else (and selected lines, for
  // their highlight) keeps its own renderer.
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
