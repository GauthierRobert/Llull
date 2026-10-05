/**
 * @layer ui/viewport/2d
 *
 * Click-to-select for the 2D view while no draw or modify tool is armed.
 * Plain click selects the entity under the cursor (nearest outline, else the smallest closed
 * shape containing the point), Shift/Ctrl/Meta-click toggles it, a click on empty
 * space clears the selection. A drag (pan) is not a click. Selection is local view state.
 * The capture plane sits in front of the snap plane: the snap plane stops pointer propagation,
 * which would otherwise occlude this one; having no move handler, this plane lets moves through.
 */

import type { Entity } from '@core/model/types';
import { useStore, useViewportStore } from '@ui/store';
import { pickEntityId } from './modifyHelpers';
import { GroundPlane, toDocumentPoint } from './GroundPlane';

/** Pick radius in screen pixels. */
const PICK_RADIUS_PX = 10;

/** Pointer travel (px) above which a press is a pan, not a click. */
const CLICK_MAX_TRAVEL_PX = 4;

interface SelectPickInteractionProps {
  /** Current ortho camera zoom (px per world unit) — scales the pick radius. */
  zoom: number;
}

export function SelectPickInteraction({ zoom }: SelectPickInteractionProps): React.ReactElement {
  return (
    <GroundPlane
      z={0.002}
      onClick={(e) => {
        if (e.delta > CLICK_MAX_TRAVEL_PX) return;
        const state = useStore.getState();
        const tolerance = PICK_RADIUS_PX / (zoom > 0 ? zoom : 1);
        const { hiddenLayerIds, hiddenEntityIds } = useViewportStore.getState();
        const { layers } = state.document;
        // Only what the 2D view draws is pickable (same filters as Entities2D).
        const isVisible = (entity: Entity): boolean =>
          layers[entity.layerId]?.visible !== false &&
          !hiddenLayerIds.has(entity.layerId) &&
          !hiddenEntityIds.has(entity.id);
        const id = pickEntityId(state.document, toDocumentPoint(e.point), tolerance, isVisible);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (id === null) {
          if (!additive) state.clearSelection();
        } else if (additive) {
          state.toggleSelection(id);
        } else {
          state.select([id]);
        }
      }}
    />
  );
}
