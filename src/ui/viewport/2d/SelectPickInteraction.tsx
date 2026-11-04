// Click-to-select in 2D with no tool armed: plain click selects (nearest outline, else smallest enclosing closed
// shape), Shift/Ctrl/Meta toggles, empty space clears (and drops the panel highlight); a pan is not a click. The plane sits in front of the snap plane
// (which stops propagation) and, with no move handler, lets moves through.

import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';
import { pickEntityId } from './modifyHelpers';
import { pickContext } from './pickContext';
import { GroundPlane, toDocumentPoint } from './GroundPlane';
import { usePidViewStore } from '@ui/store/pidViewStore';
import { pidGlyphAt } from './pidSheetItems';
import { isAdditiveSelect } from '../selectClick';

/** Pointer travel (px) above which a press is a pan, not a click. */
const CLICK_MAX_TRAVEL_PX = 4;

interface SelectPickInteractionProps {
  /** Px per world unit; scales the pick radius. */
  zoom: number;
}

export function SelectPickInteraction({ zoom }: SelectPickInteractionProps): React.ReactElement {
  return (
    <GroundPlane
      z={0.002}
      onClick={(e) => {
        if (e.delta > CLICK_MAX_TRAVEL_PX) return;
        const state = useStore.getState();
        // Same visibility filters as Entities2D.
        const { document, tolerance, accepts } = pickContext(zoom);
        const id = pickEntityId(document, toDocumentPoint(e.point), tolerance, accepts);
        const additive = isAdditiveSelect(e);
        const pidView = usePidViewStore.getState();
        if (id === null) {
          // P&ID items are not entities: the sheet drawn is hit-tested when no entity is under the pointer.
          const { layers } = document;
          const glyph = pidGlyphAt(
            document.plant?.pid,
            pidView.activeSheetId,
            toDocumentPoint(e.point),
            tolerance,
            (layer) => layers[`layer-${layer}`]?.visible !== false,
          );
          if (glyph !== null) {
            state.clearSelection();
            useFocusStore.getState().setFocus(null);
            pidView.setPicked({ id: glyph.id, kind: glyph.kind });
          } else if (!additive) {
            state.clearSelection();
            useFocusStore.getState().setFocus(null);
            pidView.setPicked(null);
          }
          return;
        }
        pidView.setPicked(null);
        if (additive) state.toggleSelection(id);
        else state.select([id]);
      }}
    />
  );
}
