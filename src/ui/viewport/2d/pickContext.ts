/**
 * @layer ui/viewport/2d
 *
 * The inputs every 2D click-pick shares: the live document, the pick tolerance in world units for
 * the current zoom, and the "is this entity drawn" filter (layers + local hiding, same as
 * Entities2D). Read at click time from the stores, so handlers never close over stale state.
 */

import type { CadDocument, Entity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityVisible } from '../entityVisibility';
import { PICK_RADIUS_PX } from './modifyHelpers';

interface PickContext {
  document: CadDocument;
  /** Pick radius in document units. */
  tolerance: number;
  /** Visible entities, further narrowed by `extraFilter` when given. */
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
