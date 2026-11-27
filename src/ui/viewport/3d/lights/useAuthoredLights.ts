// The light entities that are drawn (their layer is visible and neither the entity nor the layer is hidden in the viewport), in
// document order. Derived from the entity bag, so a selection change returns the same array.

import { useMemo } from 'react';
import type { LightEntity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../../entityVisibility';

const NONE: readonly LightEntity[] = [];

export function useAuthoredLights(): readonly LightEntity[] {
  const order = useStore((s) => s.document.order);
  const entities = useStore((s) => s.document.entities);
  const layers = useStore((s) => s.document.layers);
  const hiddenLayerIds = useViewportStore((s) => s.hiddenLayerIds);
  const hiddenEntityIds = useViewportStore((s) => s.hiddenEntityIds);
  return useMemo(() => {
    const lights: LightEntity[] = [];
    for (const id of order) {
      const entity = entities[id];
      if (entity?.kind === 'light' && isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds)) lights.push(entity);
    }
    return lights.length === 0 ? NONE : lights;
  }, [order, entities, layers, hiddenLayerIds, hiddenEntityIds]);
}
