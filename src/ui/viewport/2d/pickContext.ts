// Shared click-pick inputs read at click time (never stale): live document, zoom tolerance, Entities2D visibility filter.

import type { CadDocument, Entity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { PICK_RADIUS_PX } from './modifyHelpers';

interface PickContext {
  document: CadDocument;
  /** Document units. */
  tolerance: number;
  /** Visible, narrowed by `extraFilter`. */
  accepts: (entity: Entity) => boolean;
}

export function pickContext(zoom: number, extraFilter?: (entity: Entity) => boolean): PickContext {
  const { document } = useStore.getState();
  const { hiddenLayerIds, hiddenEntityIds } = useViewportStore.getState();
  const { layers } = document;
  return {
    document,
    tolerance: PICK_RADIUS_PX / (zoom > 0 ? zoom : 1),
    accepts: (entity) => (extraFilter?.(entity) ?? true) && isEntityVisible(entity, layers, hiddenLayerIds, hiddenEntityIds),
  };
}
